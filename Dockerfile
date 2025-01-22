FROM node:lts AS build_image

WORKDIR /app

COPY . /app

RUN yarn install --registry https://registry.npmmirror.com/ --ignore-engines && yarn run build

FROM node:lts-alpine

COPY --from=build_image /app/configs /app/configs
COPY --from=build_image /app/package.json /app/package.json
COPY --from=build_image /app/dist /app/dist
COPY --from=build_image /app/public /app/public
COPY --from=build_image /app/node_modules /app/node_modules

WORKDIR /app

EXPOSE 8000

CMD ["npm", "start"]