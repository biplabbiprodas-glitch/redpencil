// Ad-hoc signs the Mac app so macOS will open it (no paid Apple certificate needed).
const { execSync } = require('child_process');
exports.default = async function (ctx) {
  if (ctx.electronPlatformName !== 'darwin') return;
  const appPath = ctx.appOutDir + '/' + ctx.packager.appInfo.productFilename + '.app';
  execSync('codesign --force --deep --sign - "' + appPath + '"', { stdio: 'inherit' });
  execSync('codesign --verify --verbose "' + appPath + '"', { stdio: 'inherit' });
};
