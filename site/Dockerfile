# lima.liamhosfeld.com: static download page. nginx-unprivileged runs as a
# non-root user and listens on 8080, Cloud Run's default port.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/security-headers.conf
COPY public/ /usr/share/nginx/html/
