import nextVitals from 'eslint-config-next/core-web-vitals';
export default [...nextVitals,{ignores:['.next/**','.next-e2e/**','next-env.d.ts']}];
