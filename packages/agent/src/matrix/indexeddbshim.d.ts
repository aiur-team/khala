// The shim exports its declarations under dist/, but its explicit Node entry
// points use the wildcard export without a types condition.
declare module 'indexeddbshim/src/node.js' {
  export { default } from 'indexeddbshim/dist/node.js';
}
declare module 'indexeddbshim/src/nodeWebSQL.js' {
  export { default } from 'indexeddbshim/dist/nodeWebSQL.js';
}
