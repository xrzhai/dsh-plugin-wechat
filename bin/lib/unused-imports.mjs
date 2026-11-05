import { parse } from 'espree'
import { analyze } from 'eslint-scope'

// Use lexical references, not word counts: comments, strings and shadowed
// variables must not make an unused import appear live. Scope is imports only;
// unused parameters and other legacy locals are outside this cleanup.
export function unusedImports(source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true })
  const manager = analyze(ast, { ecmaVersion: 2022, sourceType: 'module' })
  return manager.scopes.flatMap(scope => scope.variables
    .filter(variable => variable.defs.some(def => def.type === 'ImportBinding') && variable.references.length === 0)
    .map(variable => ({ name: variable.name, line: variable.identifiers[0].loc.start.line })))
}
