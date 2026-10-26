// EAS runs this before dependency installation/prebuild. Move the checked-in
// production native project out of the build workspace so CNG uses staging IDs.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
function prepare(root,env=process.env){
 if(env.APP_VARIANT!=='staging')return;
 if(env.EAS_BUILD!=='true')throw Error('This hook only runs inside an isolated EAS build workspace');
 const platform=env.EAS_BUILD_PLATFORM;
 if(!['ios','android'].includes(platform))throw Error('Unknown EAS platform');
 const native=path.join(root,platform);
 if(fs.existsSync(native)){
  const backup=fs.mkdtempSync(path.join(os.tmpdir(),'ghostel-staging-native-'));
  fs.renameSync(native,path.join(backup,platform));
  console.log('Production native directory moved aside; EAS will prebuild the staging variant.');
 }
}
if(require.main===module)prepare(path.resolve(__dirname,'..'));
module.exports={prepare};
