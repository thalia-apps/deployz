FROM php:8.3-cli-alpine
WORKDIR /app
COPY router.php ./
EXPOSE 9000
CMD ["sh", "-c", "exec php -S 0.0.0.0:${PORT:-9000} router.php"]
