FROM --platform=$BUILDPLATFORM golang:1.23-alpine AS build
ARG TARGETARCH
WORKDIR /src
COPY go.mod main.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH go build -o /out/app .

FROM alpine:3.20
COPY --from=build /out/app /app
EXPOSE 8080
CMD ["/app"]
