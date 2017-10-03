const {
  getAssignmentExpressionStatement, getGoogExpressionStatement, getGoog2ExpressionStatement,
  getGoogVariableDeclaration, symbolToRelativePath} = require('./util');


module.exports = (info, api, options) => {
  const j = api.jscodeshift;
  const root = j(info.source);

  // store any initial comments
  const {comments} = root.find(j.Program).get('body', 0).node;

  let currentModuleSymbol;

  // Remove goog.module.declareLegacyNamespace
  root.find(j.ExpressionStatement, getGoog2ExpressionStatement('module', 'declareLegacyNamespace'))
    .forEach(path => {
      path.replace();
    });

  // Remove goog.module('module.symbol') and get the module symbol
  root.find(j.ExpressionStatement, getGoogExpressionStatement('module'))
    .forEach(path => {
      if (currentModuleSymbol) {
        throw new Error('Already existing goog.module found in this file', currentModuleSymbol);
      }
      currentModuleSymbol = path.value.expression.arguments[0].value;
      path.replace();
    });

  // Append  "export default exports;" to the body
  const noExport = !currentModuleSymbol;
  if (noExport) {
    if (!options['allow-no-goog-module'] ) {
      throw new Error('No goog.module found in this file');
    }
    currentModuleSymbol = 'a.fake.symbol.since.there.is.no.module.in.this.file';
  }

  // Transform "const xx = goog.require('X.Y.Z');" into a relative path like "import xx from '../Y/Z';"
  root.find(j.VariableDeclarator, getGoogVariableDeclaration('require')).forEach(path => {
    const name = path.value.id.name;
    const symbol = path.value.init.arguments[0].value;
    if (!name) {
      throw new Error('Could not transform symbol ' + symbol + '; note that unstructuring is not supported');
    }
    const importStatement = j.importDeclaration(
      [j.importDefaultSpecifier(j.identifier(name))],
      j.literal(symbolToRelativePath(currentModuleSymbol, symbol))
    );
    path.parent.replace(importStatement);
  });

  if (!noExport) {
    let foundExportsAssignment = false;
    root.find(j.ExpressionStatement, getAssignmentExpressionStatement('exports')).forEach(path => {
      if (foundExportsAssignment) {
        throw new Error('Already existing exports assignment in this file');
      }
      foundExportsAssignment = true;
      const right = path.value.expression.right;
      const assignment = j.variableDeclaration('const', [
        j.variableDeclarator(
          j.identifier('exports'),
          right
        )
      ]);
      path.replace(assignment);
    });

    if (!foundExportsAssignment) {
      // Case of a namespace
      const declaration = j.variableDeclaration('let', [
        j.variableDeclarator(
          j.identifier('exports'),
          j.objectExpression([])
        )]);

      root.find(j.Program).get('body').unshift(declaration);
    }
    root.find(j.Program).get('body').push(j.exportDefaultDeclaration(j.identifier('exports')));
  }

  // replace any initial comments
  root.get().node.comments = comments;

  // add @module annotation for src modules
  if (info.path.startsWith('src')) {
    const name = info.path.replace(/^src\//, '').replace(/\.js$/, '');
    const comment = j.commentBlock(`*\n * @module ${name}\n `);
    const node = root.get().node;
    if (!node.comments) {
      node.comments = [comment];
    } else {
      node.comments.unshift(comment);
    }
  }

  return root.toSource({quote: 'single'});
};
