# Egress proxy for sandboxes in network mode "egress". Managed by cocoond.
FROM docker.io/library/node:24-alpine
COPY proxy.mjs translate.mjs placeholders.mjs /app/
EXPOSE 3128 8080
CMD ["node", "/app/proxy.mjs"]
