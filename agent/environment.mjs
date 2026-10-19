import {stableUrls,repositories} from '../previews/manifest.mjs';
import {buildVariables} from '../previews/frontend.mjs';
export function verificationEnvironment(service) {
  if(!service.endsWith('_frontend'))return {CI:'true'};
  const backend=service==='designer_frontend'?'designer_backend':'workbench_backend';
  return {CI:'true',...buildVariables({services:{[service]:{repository:repositories[service]}},frontendBuildVariables:{[service]:{
    VITE_APP_BACKEND:stableUrls[backend],VITE_AUTH_SERVICE_BACKEND:stableUrls.auth,VITE_WORKBENCH_URL:stableUrls.workbench_frontend}}},service)};
}
