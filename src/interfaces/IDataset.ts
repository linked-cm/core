import type {SelectQuery} from '../queries/SelectQuery.js';
import type {CreateQuery} from '../queries/CreateQuery.js';
import type {UpdateQuery} from '../queries/UpdateQuery.js';
import type {DeleteQuery, DeleteResponse} from '../queries/DeleteQuery.js';
import type {
  SelectResult,
  CreateResult,
  UpdateResult,
} from '../queries/IntermediateRepresentation.js';

/**
 * Universal dataset interface. Every dataset in the Linked framework accepts
 * Linked Queries as input. The implementing class decides how to handle them —
 * compiling to SPARQL for Fuseki, forwarding as-is to a Host Agent API, etc.
 *
 * Each method receives a canonical IR query object and returns the result.
 * The calling layer (LinkedStorage via queryDispatch) threads the precise
 * DSL-level TypeScript result type back to the caller.
 */
export interface IDataset {
  /**
   * Prepares the store to be used.
   */
  init?(): Promise<any>;

  selectQuery(query: SelectQuery): Promise<SelectResult>;
  updateQuery?(query: UpdateQuery): Promise<UpdateResult>;
  createQuery?(query: CreateQuery): Promise<CreateResult>;
  deleteQuery?(query: DeleteQuery): Promise<DeleteResponse>;
}
