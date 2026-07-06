/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Shared thenable base for the mutation builders (Create/Update/Delete).
 *
 * Each builder is a lazy, `await`-able handle: it implements the full
 * `Promise<R>` surface by delegating to its own `exec()`, so `await builder`
 * runs the mutation. This base holds the identical `then`/`catch`/`finally`/
 * `Symbol.toStringTag` wiring; subclasses provide only `exec()` and a `_tag`.
 */
export abstract class MutationThenable<R> implements PromiseLike<R>, Promise<R> {
  /** Execute the mutation. Subclasses implement the dispatch. */
  abstract exec(): Promise<R>;

  /** Class name reported by `Symbol.toStringTag` (stable under minification). */
  protected abstract readonly _tag: string;

  then<TResult1 = R, TResult2 = never>(
    onfulfilled?: ((value: R) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.exec().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null,
  ): Promise<R | TResult> {
    return this.then().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<R> {
    return this.then().finally(onfinally);
  }

  get [Symbol.toStringTag](): string {
    return this._tag;
  }
}
