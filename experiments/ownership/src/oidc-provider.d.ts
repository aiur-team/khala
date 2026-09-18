// oidc-provider ships no type declarations; the experiment uses a narrow surface.
declare module 'oidc-provider' {
  const Provider: any;
  export default Provider;
}
