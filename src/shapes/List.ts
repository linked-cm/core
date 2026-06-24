/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {linkedShape} from '../package.js';
import {Shape} from './Shape.js';
import {linkedProperty, objectProperty} from './SHACL.js';
import {rdf} from '../ontologies/rdf.js';

/**
 * SHACL/RDF ordered-list cell shape (`rdf:List`).
 *
 * A list is a chain of cells: `first` holds the value, `rest` points to the next cell
 * (or `rdf:nil`). The cell is `dependent` (it has no independent existence) and `rest` is
 * a `contains` edge, so deleting/replacing a list cascade-cleans the whole spine — while
 * `first` is NOT a `contains` edge, so the list's *contents* (shared IRIs/values) are kept.
 * See plan-001.
 */
@linkedShape({dependent: true})
export class List<T = unknown> extends Shape {
  static targetClass = rdf.List;

  @linkedProperty({path: rdf.first, maxCount: 1})
  get first(): T {
    return null;
  }

  @objectProperty({path: rdf.rest, maxCount: 1, shape: List, contains: true})
  get rest(): List<T> {
    return null;
  }
}

/**
 * Node-data for a single cell / the `rdf:nil` terminal. Accepted by the create pipeline.
 */
export type RdfListNodeData =
  | {id: string}
  | {shape: typeof List; first: unknown; rest: RdfListNodeData; __id?: string};

/**
 * Build the nested `List` node-data chain for an ordered `rdf:List`, terminating at `rdf:nil`.
 * Pass `opts.base` to mint deterministic cell ids (`{base}/0`, `{base}/1`, …); otherwise the
 * create pipeline mints ids. The empty list serializes to `rdf:nil`.
 *
 * @example Playlist.create({ tracks: rdfList([t1, t2, t3]) })
 */
export function rdfList<T>(
  items: T[],
  opts?: {base?: string},
): RdfListNodeData {
  const base = opts?.base;
  const build = (i: number): RdfListNodeData => {
    if (i >= items.length) {
      return {id: rdf.nil.id};
    }
    const cell: RdfListNodeData = {
      shape: List,
      first: items[i],
      rest: build(i + 1),
    };
    if (base !== undefined) {
      cell.__id = `${base}/${i}`;
    }
    return cell;
  };
  return build(0);
}
