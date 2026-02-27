#!/bin/bash
set -e

npm install

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — fill in the values before continuing."
  exit 1
fi

npx supabase link --project-ref kipivwazyabxruteygfb
npm run db:push
npm run build

pm2 start ecosystem.config.cjs
pm2 save
