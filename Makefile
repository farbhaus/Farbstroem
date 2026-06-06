# Farbström — thin wrappers around the two compose files.
#
#   make deploy   start on a deploy host (pulls the published image)
#   make update   pull the newest image and recreate (live sessions survive)
#   make dev      build from source + bind-mount ./www for live frontend edits
#   make logs     follow all services' logs
#   make status   per-service supervisord state inside the container
#   make down     stop and remove the container
#
# `dev` selects both files; everything else uses the base only (image deploy).

BASE := -f docker-compose.yml
DEV  := -f docker-compose.yml -f docker-compose.dev.yml

.PHONY: deploy update dev logs status down

deploy:
	docker compose $(BASE) up -d

update:
	docker compose $(BASE) pull
	docker compose $(BASE) up -d

dev:
	docker compose $(DEV) up -d --build

logs:
	docker compose $(BASE) logs -f

status:
	docker exec farbstroem supervisorctl status

down:
	docker compose $(BASE) down
