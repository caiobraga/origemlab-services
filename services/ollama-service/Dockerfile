FROM ollama/ollama:latest
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
COPY start.sh /start.sh
RUN chmod +x /start.sh
ENTRYPOINT ["/bin/sh", "/start.sh"]
