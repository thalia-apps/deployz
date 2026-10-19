# The probe container: HTTP status checks and /proc/net reads from inside the
# run network, and the certificate helper of the service sets (openssl). It is
# harness code and runs on the host platform (arm64 locally, amd64 on a runner).
ARG LIBRARY=public.ecr.aws/docker/library
FROM ${LIBRARY}/alpine:3.20
RUN apk add --no-cache curl openssl
