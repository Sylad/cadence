/**
 * Bac à sable des sessions de vague (L168) : une session ne touche pas à la production. Idée reprise du sandbox de
 * docker/docker-agent (réseau fermé par défaut), ramenée à ce que cadence maîtrise : l'environnement du processus.
 *
 * Mesuré sur Big-Blue : une session hérite de `KUBECONFIG` (qui désigne `~/.kube/config`, donc la prod) ; `kubectl` du
 * PATH est un lien vers k3s, qui sans `KUBECONFIG` retombe sur `/etc/rancher/k3s/k3s.yaml`. `KUBECONFIG=/dev/null`
 * coupe les deux : `kubectl get pods` répond « connection refused » sur localhost:8080.
 */

/** Variables qui donnent un accès à la production ou au cloud : retirées de l'environnement des sessions. */
export const PROD_VARS = [
  'KUBERNETES_SERVICE_HOST',
  'KUBERNETES_SERVICE_PORT',
  'KUBE_TOKEN',
  'ARGOCD_SERVER',
  'ARGOCD_AUTH_TOKEN',
  'ARGOCD_OPTS',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_API_KEY',
  'CF_API_TOKEN',
  'CF_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_CLIENT_SECRET',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
];

/** Ce qu'il faut ajouter et retirer de l'environnement d'une session. `prodAccess` (cadence.yaml) lève la restriction. */
export function sandboxEnv(prodAccess: boolean): { set: Record<string, string>; unset: string[] } {
  if (prodAccess) return { set: {}, unset: [] };
  return { set: { KUBECONFIG: '/dev/null' }, unset: [...PROD_VARS] };
}
