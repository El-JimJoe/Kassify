FROM nginx:1.27-alpine

RUN apk add --no-cache python3 \
    && mkdir -p /data /app

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY web/ /usr/share/nginx/html/
COPY api/ /app/
COPY docker/entrypoint.sh /entrypoint.sh

RUN sed -i 's/\r$//' /entrypoint.sh /app/*.py \
    && chmod +x /entrypoint.sh

VOLUME /data
EXPOSE 80

ENV KASSIFY_DATA=/data \
    KASSIFY_HOST=127.0.0.1 \
    KASSIFY_PORT=3000 \
    KASSIFY_CORS=*

ENTRYPOINT ["/entrypoint.sh"]
