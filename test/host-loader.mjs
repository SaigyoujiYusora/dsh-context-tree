import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
// Set DSH_HOST_MODULES when running tests with Node instead of Desktop's Electron.
const modules=process.env.DSH_HOST_MODULES ?? path.join(path.dirname(process.execPath),'resources/app.asar/dsh/node_modules');
const parentURL=pathToFileURL(path.join(modules,'@deepseek-ai/dsh/package.json')).href;
registerHooks({resolve(specifier,context,next){
  if(specifier.startsWith('@deepseek-ai/')) return next(specifier,{...context,parentURL});
  return next(specifier,context);
}});
