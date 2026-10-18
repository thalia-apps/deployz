# The probe container: HTTP status checks and /proc/net reads from inside the
# run network, and the certificate helper of the service sets (openssl). It is
# harness code and runs native (arm64).
FROM public.ecr.aws/docker/library/alpine:3.20
RUN apk add --no-cache curl openssl
