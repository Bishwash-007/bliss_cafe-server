# Use lightweight Node image
FROM node:20-alpine

# Set working directory inside container
WORKDIR /usr/src/app

# Copy dependency definitions
COPY package*.json ./

# Install dependencies (including 'pg' native driver)
RUN npm install

# Copy application source code
COPY . .

# Expose NestJS port
EXPOSE 3000

# Start app in development watch mode
CMD ["npm", "run", "start:dev"]
