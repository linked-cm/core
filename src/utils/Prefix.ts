/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
export class Prefix {
  static uriToPrefix: Map<string, string> = new Map();
  static prefixToUri: Map<string, string> = new Map();

  static getUriToPrefixMap() {
    return this.uriToPrefix;
  }

  static getPrefixToUriMap() {
    return this.prefixToUri;
  }

  static add(prefix: string, fullURI: string) {
    this.uriToPrefix.set(fullURI, prefix);
    this.prefixToUri.set(prefix, fullURI);
  }

  static delete(prefix: string) {
    if (this.prefixToUri.has(prefix)) {
      let fullURI = this.getFullURI(prefix);
      this.uriToPrefix.delete(fullURI);
      this.prefixToUri.delete(prefix);
    }
  }

  static clear() {
    this.uriToPrefix = new Map<string, string>();
    this.prefixToUri = new Map<string, string>();
  }

  static getPrefix(fullURI: string): string {
    if (this.uriToPrefix.has(fullURI)) {
      return this.uriToPrefix.get(fullURI);
    }
    let match = this.findMatch(fullURI);
    if (match.length > 0) return match[1];
  }

  static getFullURI(prefix: string): string {
    return this.prefixToUri.get(prefix);
  }


  static findMatch(fullURI: string): [string, string, string] | [] {
    for (let [ontologyURI, prefix] of this.uriToPrefix.entries()) {
      if (fullURI.substring(0, ontologyURI.length) == ontologyURI) {
        return [ontologyURI, prefix, fullURI.substring(ontologyURI.length)];
      }
    }
    return [];
  }

  static toPrefixed(fullURI: string) {
    let match = this.findMatch(fullURI);
    if (match.length > 0) {
      const postFix = fullURI.substring(match[0].length);
      if (!postFix.includes('/')) {
        return match[1] + ':' + postFix;
      }
    }
  }

  static toPrefixedIfPossible(fullURI: string) {
    return this.toPrefixed(fullURI) || fullURI;
  }

  static toFullIfPossible(fullURI: string): string {
    let res = this._toFull(fullURI);
    if(res) {
      return res;
    }
    return fullURI;
  }

  /**
   * Converts a prefixed URI back to its full URI
   * Will return the prefixed URI if no prefix was found
   * @param uri
   */
  static toFull(uri) {
    let res = this._toFull(uri);
    if(res) {
      return res;
    }
    const colon = uri.indexOf(':');
    const prefix = colon === -1 ? uri : uri.slice(0, colon);
    throw new Error(
      'Unknown prefix ' +
        prefix +
        '. Could not convert ' +
        uri +
        ' to a full URI',
    );
  }
  private static _toFull(uri) {
    // Split on the FIRST colon only: the local name may itself contain colons
    // (e.g. `ex:foo:bar`), which `split(':')` would truncate.
    const colon = uri.indexOf(':');
    if (colon === -1) return undefined;
    const prefix = uri.slice(0, colon);
    const rest = uri.slice(colon + 1);
    let ontologyURI = this.getFullURI(prefix);
    if (ontologyURI) {
      return ontologyURI + rest;
    }
  }
}
