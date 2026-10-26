const {test}=require('node:test');
const assert=require('node:assert/strict');
const {stagingConfig}=require('../frontend/config/staging.cjs');
const base=require('../frontend/app.json').expo;
const env={APP_VARIANT:'staging',EXPO_PUBLIC_APP_VARIANT:'staging',EXPO_STAGING_NO_PUSH:'1',EXPO_PUBLIC_BACKEND_URL:'http://127.0.0.1:18794'};
test('staging has separate app identifiers, scheme, backend and no production Firebase file',()=>{
 const c=stagingConfig(base,env); assert.equal(c.ios.bundleIdentifier,'app.ghostel.staging');assert.equal(c.android.package,'app.ghostel.staging');assert.equal(c.scheme,'ghostel-staging');assert.equal(c.extra.stagingBackendUrl,env.EXPO_PUBLIC_BACKEND_URL);assert.equal(c.android.googleServicesFile,undefined);assert.equal(c.ios.googleServicesFile,undefined);assert.equal(base.android.package,'app.ghostel');
});
test('staging rejects missing, production and insecure remote backends',()=>{
 assert.throws(()=>stagingConfig(base,{...env,EXPO_PUBLIC_APP_VARIANT:undefined}),/EXPO_PUBLIC_APP_VARIANT/);
 for(const value of [undefined,'https://API.GHOSTEL.APP.','https://api.ghostel.app','http://staging.example.com','https://user:password@staging.example.com','https://staging.example.com/api']) assert.throws(()=>stagingConfig(base,{...env,EXPO_PUBLIC_BACKEND_URL:value}));
});
test('staging push requires explicit separate Firebase configuration',()=>assert.throws(()=>stagingConfig(base,{...env,EXPO_STAGING_NO_PUSH:'0'})));
test('production config is preserved without a staging variant',()=>assert.equal(stagingConfig(base,{}),base));
test('native staging hook refuses to modify a normal local checkout',()=>{
 const {prepare}=require('../frontend/scripts/prepare-eas-staging.cjs');
 assert.throws(()=>prepare('/does-not-exist',{APP_VARIANT:'staging',EAS_BUILD_PLATFORM:'android'}),/isolated EAS/);
 assert.doesNotThrow(()=>prepare('/does-not-exist',{}));
});
