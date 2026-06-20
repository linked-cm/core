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

export const coreOntology = {
  Package,
  ShapeClass,
  definesShape,
  module: moduleProperty,
  usesShapeClass,
  editInline,
  isExtending,
};
