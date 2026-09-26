cp .env.example .env
docker compose up -d
# open http://localhost:8080 (Adminer) to browse the schema
docker exec -i cafe_saas_db psql -U cafe_admin -d cafe_saas < db/seed/seed.sql