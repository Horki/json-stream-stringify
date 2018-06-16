import {
  Transform,
  PassThrough,
} from 'stream';
import CoStream from './CoStream';
import RecursiveIterable from './RecursiveIterable';
import { isReadableStream, isPromise } from './utils';

class JsonStreamStringify extends CoStream {
  constructor(value, replacer, space, _visited, _stack) {
    super(value, replacer, space, _visited, _stack);
    const replacedValue = replacer instanceof Function ? replacer(undefined, value) : value;
    this._iter = new RecursiveIterable(replacedValue, replacer, space, _visited, _stack);
  }

  * _makeGenerator() {
    let insertSeparator = false;
    // eslint-disable-next-line no-restricted-syntax
    for (const obj of this._iter) {
      if (obj.state === 'close') {
        insertSeparator = true;
        yield this.push(obj.type === Object ? '}' : ']');
        continue;
      }

      if (obj.state === 'open') {
        insertSeparator = false;
        yield this.push(obj.type === Object ? '{' : '[');
        continue;
      }

      if (insertSeparator) {
        yield this.push(',');
      }

      if (obj.key && obj.ctxType !== Array) {
        yield this.push(`${JSON.stringify(obj.key)}:`);
      }

      if (isReadableStream(obj.value)) {
        if (!obj.value._readableState.objectMode) {
          // Non Object Mode are emitted as a concatinated string
          yield this.push('"');
          yield obj.value.pipe(Object.assign(new Transform(), {
            _transform: (data, enc, next) => {
              this.push(JSON.stringify(data.toString()).slice(1, -1));
              next(null);
            },
          }));
          yield this.push('"');
          continue;
        }

        // Object Mode Streams are emitted as arrays
        let first = true;
        const arrayStream = new PassThrough();
        let index = 0;
        obj.value.pipe(Object.assign(new Transform({
          objectMode: true,
        }), {
          _transform: (data, enc, next) => {
            if (!first) {
              arrayStream.push(',');
            }
            first = false;
            const stream = new JsonStreamStringify(
              data,
              this._iter.replacer,
              this._iter.space,
              this._iter.visited,
            );
            stream._iter._stack = obj.stack.concat(index);
            index += 1;
            stream._iter._parentCtxType = Array;
            // pipe to arrayStream but don't close arrayStream on end
            stream.once('end', () => next(null, undefined));
            stream.pipe(arrayStream, { end: false });
          },
        })).once('end', () => arrayStream.end()).resume();

        yield this.push('[');
        yield arrayStream;
        yield this.push(']');

        continue;
      }

      if (obj.state === 'circular') {
        yield this.push(JSON.stringify({ $ref: `$${obj.value.map(v => `[${JSON.stringify(v)}]`).join('')}` }));
      }

      if (isPromise(obj.value)) {
        const val = yield obj.value;
        const childIterator = new RecursiveIterable(
          val,
          this._iter.replacer,
          this._iter.space,
          this._iter.visited,
          obj.stack.concat(obj.key || []),
        )[Symbol.iterator]();
        obj.value = obj.attachChild(childIterator, obj.key);
        insertSeparator = false;
        continue;
      }

      if (obj.state === 'value') {
        yield this.push(JSON.stringify(obj.value));
      }

      insertSeparator = true;
    }
    this._iter = undefined;
  }
}

const fakeMap = {
  has: () => false,
  set: () => undefined,
};

function jsonStreamStringify(value, replacer, space, cycle) {
  return new JsonStreamStringify(value, replacer, space, !cycle && fakeMap);
}

export default jsonStreamStringify;