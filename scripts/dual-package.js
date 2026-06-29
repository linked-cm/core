const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname,'..');
const libDir = path.join(root,'lib');
const cjsDir = path.join(libDir,'cjs');
const esmDir = path.join(libDir,'esm');

const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir,{recursive: true});
  }
};

// Mirror the root manifest's sideEffects into each variant. Bundlers read the
// *nearest* package.json for sideEffects, so these nested manifests must carry
// it too (paths are relative to this dir — the `**/` prefix matches either way)
// or tree-shaking defaults back to "everything has side effects".
const rootPkg = require(path.join(root,'package.json'));

const writePackageJson = (dir,type) => {
  ensureDir(dir);
  const pkgPath = path.join(dir,'package.json');
  const data = {
    type,
    sideEffects: rootPkg.sideEffects,
  };
  fs.writeFileSync(pkgPath,JSON.stringify(data,null,2));
};

writePackageJson(cjsDir,'commonjs');
writePackageJson(esmDir,'module');
