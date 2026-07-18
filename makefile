run:
	docker compose up --build

build:
	docker build . --tag service-$financebot
