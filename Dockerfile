# vmcheck —— 设备控制脚本 JSON 命令行校验器
# 多阶段构建：先编译 TypeScript，再以精简运行镜像交付；容器内即“同一入口”。
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /app/dist ./dist
# 示例程序随镜像提供，便于 `docker compose run --rm vmcheck samples/ok.json`
COPY samples ./samples
# 测试同样在镜像内可跑（开发校验）
COPY --from=build /app/node_modules ./node_modules
COPY vitest.config.ts ./
COPY test ./test
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--help"]
