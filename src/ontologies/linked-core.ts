import type {NodeReferenceValue} from '../utils/NodeReference.js';
import {createNameSpace} from '../utils/NameSpace.js';
import {Prefix} from '../utils/Prefix.js';

// The @_linked/core framework vocabulary. Public/first-party term URIs live on
// linked.cm following the public-ontology scheme (arch-02 §Ontology namespace model):
//   https://linked.cm/ont/{ontologySlug}/{localName}
export const ns = createNameSpace('https://linked.cm/ont/linked-core/');
export const _self: NodeReferenceValue = ns('');
Prefix.add('linked_core', _self.id);

const Package = ns('Package');
const ShapeClass = ns('ShapeClass');
const definesShape = ns('definesShape');
const moduleProperty = ns('module');
const usesShapeClass = ns('usesShapeClass');
const editInline = ns('editInline');
const isExtending = ns('isExtending');

// Containment / lifecycle vocabulary.
//   contains  — property characteristic: the cascade follows this edge (composition).
//   dependent — shape characteristic: instances may be deleted when reached via a `contains` edge.
//   PathNode  — class for SHACL property-path operator nodes (sh:inversePath/alternativePath/…).
const contains = ns('contains');
const dependent = ns('dependent');
const PathNode = ns('PathNode');

// Display vocabulary. SHACL has `sh:order` and `sh:group`, which say how properties
// are arranged; it has no way to say how *important* a property is, which is what a
// renderer needs when it can only show one, three or six of them. `displayRank` is
// that: a single linear rank per property, lower = more important, from which every
// truncated context ("show the top 3") derives. `displayHidden` removes a property
// from generic rendering without changing its cardinality or its meaning.
//
// Placement is deliberate (backlog-029): this is an ecosystem SHACL extension that
// materializes onto the pure `sh:NodeShape` and therefore travels with an ejected
// app — NOT the CN-proprietary `code:` vocab, which describes source-code structure.
const displayRank = ns('displayRank');
const displayHidden = ns('displayHidden');

export const coreOntology = {
  Package,
  ShapeClass,
  definesShape,
  module: moduleProperty,
  usesShapeClass,
  editInline,
  isExtending,
  contains,
  dependent,
  PathNode,
  displayRank,
  displayHidden,
};
