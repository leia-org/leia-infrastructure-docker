#!/bin/sh
set -eu
umask 077
publish_certificate() {
  test -s /certs/certificates/leia-preview.crt
  test -s /certs/certificates/leia-preview.key
  # Publish only after lego has finished updating both files. The proxy watches this directory.
  cat > /dynamic/.leia-preview-tls.tmp <<'TLS'
tls:
  certificates:
    - certFile: /traefik/preview-certs/certificates/leia-preview.crt
      keyFile: /traefik/preview-certs/certificates/leia-preview.key
TLS
  mv /dynamic/.leia-preview-tls.tmp /dynamic/leia-preview-tls.yaml
}
trap 'exit 0' TERM INT
while :; do
  if lego run --path /certs --cert.name leia-preview --email experimentia@us.es \
    --accept-tos --dns cloudflare --domains leia.ovh --domains '*.leia.ovh'; then
    publish_certificate
  else
    # A temporary renewal failure keeps the existing certificate loaded.
    echo 'Preview certificate acquisition/renewal failed; existing certificates are preserved.' >&2
  fi
  sleep 43200 &
  wait "$!" || true
done
