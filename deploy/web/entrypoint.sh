#!/bin/sh
# The web site: write the runtime configuration from the environment, then run nginx.
#
#   WEB_NETWORK                  stagenet (default) or undeployed: the network profile the site uses
#   WEB_SPONSOR_URL              the sponsor's base URL as the browser sees it (default /sponsor, the
#                                same-origin proxy below); an absolute https URL for a separate host
#   WEB_SPONSOR_UPSTREAM         where nginx reaches the sponsor (default sponsor:8080)
#   WEB_TRUSTED_PROXIES          addresses whose X-Forwarded-For nginx believes (comma-separated
#                                CIDRs): the reverse proxy in front, so the sponsor's rate limits key
#                                on each user and not on the proxy
#   WEB_DNS_RESOLVER             DNS for the sponsor's name (default 127.0.0.11, Docker's)
#   WEB_CONTENT_SECURITY_POLICY  optional Content-Security-Policy header value
#
# A full site configuration can be mounted at /etc/emt/config.json instead (for example with
# network overrides or a Midnight explorer URL, questions Q11); it is then served as is.
# Adapted from MN Bank (acedward/passport-evm-dapp @ 911647b, deploy/web/entrypoint.sh).
set -eu

D=/tmp/emt
fail() {
  echo "emt-web: $*" >&2
  exit 78
}

network="${WEB_NETWORK:-stagenet}"
sponsor_url="${WEB_SPONSOR_URL:-/sponsor}"
upstream="${WEB_SPONSOR_UPSTREAM:-sponsor:8080}"
resolver="${WEB_DNS_RESOLVER:-127.0.0.11}"
trusted="${WEB_TRUSTED_PROXIES:-}"
csp="${WEB_CONTENT_SECURITY_POLICY:-}"

case "$network" in stagenet | undeployed) ;; *) fail "WEB_NETWORK must be stagenet or undeployed" ;; esac
case "$sponsor_url" in *'"'* | *'\'* | *' '*) fail "WEB_SPONSOR_URL must not contain quotes, backslashes or spaces" ;; esac
echo "$upstream" | grep -Eq '^[A-Za-z0-9._-]+:[0-9]{1,5}$' || fail "WEB_SPONSOR_UPSTREAM must be host:port"
echo "$resolver" | grep -Eq '^[0-9A-Fa-f.:]+$' || fail "WEB_DNS_RESOLVER must be an IP address"
case "$csp" in *'"'* | *'\'* | *'$'*) fail "WEB_CONTENT_SECURITY_POLICY must not contain quotes, backslashes or \$" ;; esac

mkdir -p "$D" /tmp/client_body /tmp/proxy /tmp/fastcgi /tmp/uwsgi /tmp/scgi

if [ -f /etc/emt/config.json ]; then
  cp /etc/emt/config.json "$D/config.json"
else
  printf '{"network":"%s","sponsorUrl":"%s"}\n' "$network" "$sponsor_url" >"$D/config.json"
fi

{
  echo "resolver $resolver valid=10s ipv6=off;"
  echo "resolver_timeout 5s;"
  echo "map \$host \$sponsor_upstream { default \"http://$upstream\"; }"
  found=0
  for cidr in $(echo "$trusted" | tr ',' ' '); do
    echo "$cidr" | grep -Eq '^[0-9A-Fa-f.:]+(/[0-9]{1,3})?$' || fail "WEB_TRUSTED_PROXIES: '$cidr' is not an address or CIDR"
    echo "set_real_ip_from $cidr;"
    found=1
  done
  if [ "$found" = 1 ]; then
    echo "real_ip_header X-Forwarded-For;"
    echo "real_ip_recursive on;"
  fi
} >"$D/http.conf"

if [ -n "$csp" ]; then
  echo "add_header Content-Security-Policy \"$csp\" always;" >"$D/headers.conf"
else
  : >"$D/headers.conf"
fi

echo "emt-web: network $network, sponsor $sponsor_url (upstream $upstream), trusted proxies: ${trusted:-none}" >&2
exec nginx -g 'daemon off;'
