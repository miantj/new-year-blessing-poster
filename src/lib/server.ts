import Koa from 'koa';
import KoaRouter from 'koa-router';
import koaRange from 'koa-range';
import koaCors from "koa2-cors";
import koaBody from 'koa-body';
import _ from 'lodash';
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import Exception from './exceptions/Exception.ts';
import Request from './request/Request.ts';
import Response from './response/Response.js';
import FailureBody from './response/FailureBody.ts';
import EX from './consts/exceptions.ts';
import logger from './logger.ts';
import config from './config.ts';

class Server {

    app;
    router;
    
    constructor() {
        this.app = new Koa();
        this.router = new KoaRouter();

        // 获取正确的项目根目录路径
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        // 修改为项目根目录下的 public 文件夹
        const publicPath = path.resolve(__dirname, '../public');
        
        logger.debug(`Public directory path: ${publicPath}`); // 添加调试日志

        // 检查 public 目录是否存在
        fs.access(publicPath).then(() => {
            logger.success(`Public directory exists: ${publicPath}`);
        }).catch((err) => {
            logger.error(`Public directory not found: ${publicPath}`, err);
        });

        // 静态文件中间件 - 需要放在路由之前
        this.app.use(async (ctx, next) => {
            if (ctx.method !== 'GET') {
                return next();
            }

            // 构建文件路径
            let filePath = path.join(publicPath, decodeURIComponent(ctx.path));
            logger.debug(`Attempting to serve: ${filePath}`); // 添加调试日志
            
            try {
                // 检查文件是否存在
                await fs.access(filePath);
                const stats = await fs.stat(filePath);
                
                if (stats.isDirectory()) {
                    filePath = path.join(filePath, 'index.html');
                }

                // 读取文件
                const content = await fs.readFile(filePath);
                
                // 设置正确的 Content-Type
                const ext = path.extname(filePath).toLowerCase();
                const mimeTypes = {
                    '.html': 'text/html',
                    '.js': 'text/javascript',
                    '.css': 'text/css',
                    '.json': 'application/json',
                    '.png': 'image/png',
                    '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg',
                    '.gif': 'image/gif',
                    '.svg': 'image/svg+xml',
                    '.ico': 'image/x-icon',
                };
                
                ctx.type = mimeTypes[ext] || 'application/octet-stream';
                ctx.body = content;
                ctx.status = 200;  // 设置状态码为200
                return;  // 直接返回，不再继续处理
                
            } catch (err) {
                if (err.code === 'ENOENT') {
                    logger.warn(`File not found: ${filePath}`);
                    // 如果文件不存在，尝试 .png 扩展名
                    if (ctx.path.endsWith('.jpeg')) {
                        const pngPath = filePath.replace('.jpeg', '.png');
                        try {
                            await fs.access(pngPath);
                            const content = await fs.readFile(pngPath);
                            ctx.type = 'image/png';
                            ctx.body = content;
                            ctx.status = 200;  // 设置状态码为200
                            logger.debug(`Served PNG instead of JPEG: ${ctx.path}`);
                            return;  // 直接返回，不再继续处理
                        } catch (pngErr) {
                            logger.warn(`PNG alternative not found: ${pngPath}`);
                        }
                    }
                }
                // 如果文件不存在，设置404状态码
                ctx.status = 404;
                return next();
            }
        });

        // 其他中间件
        this.app.use(koaCors());
        this.app.use(koaRange);
        this.app.use(koaBody(_.clone(config.system.requestBody)));
        this.app.on("error", (err: any) => {
            // 忽略连接重试、中断、管道、取消错误
            if (["ECONNRESET", "ECONNABORTED", "EPIPE", "ECANCELED"].includes(err.code)) return;
            logger.error(err);
        });
        logger.success("Server initialized");

        // API 路由处理
        this.app.use(async (ctx, next) => {
            // 只处理 API 请求
            if (ctx.path.startsWith('/v1/')) {
                const request = new Request(ctx);
                logger.debug(`-> ${ctx.request.method} ${ctx.request.url}`);
                const message = `[请求有误]: 正确请求为 POST -> /v1/chat/completions，当前请求为 ${ctx.request.method} -> ${ctx.request.url} 请纠正`;
                logger.warn(message);
                const failureBody = new FailureBody(new Error(message));
                const response = new Response(failureBody);
                response.injectTo(ctx);
                if(config.system.requestLog)
                    logger.info(`<- ${request.method} ${request.url} ${response.time - request.time}ms`);
            }
            return next();
        });
    }

    /**
     * 附加路由
     * 
     * @param routes 路由列表
     */
    attachRoutes(routes: any[]) {
        routes.forEach((route: any) => {
            const prefix = route.prefix || "";
            for (let method in route) {
                if(method === "prefix") continue;
                if (!_.isObject(route[method])) {
                    logger.warn(`Router ${prefix} ${method} invalid`);
                    continue;
                }
                for (let uri in route[method]) {
                    this.router[method](`${prefix}${uri}`, async ctx => {
                        const { request, response } = await this.#requestProcessing(ctx, route[method][uri]);
                        if(response != null && config.system.requestLog)
                            logger.info(`<- ${request.method} ${request.url} ${response.time - request.time}ms`);
                    });
                }
            }
            logger.info(`Route ${config.service.urlPrefix || ""}${prefix} attached`);
        });
        this.app.use(this.router.routes());
    }

    /**
     * 请求处理
     * 
     * @param ctx 上下文
     * @param routeFn 路由方法
     */
    #requestProcessing(ctx: any, routeFn: Function): Promise<any> {
        return new Promise(resolve => {
            const request = new Request(ctx);
            try {
                if(config.system.requestLog)
                    logger.info(`-> ${request.method} ${request.url}`);
                    routeFn(request)
                .then(response => {
                    try {
                        if(!Response.isInstance(response)) {
                            const _response = new Response(response);
                            _response.injectTo(ctx);
                            return resolve({ request, response: _response });
                        }
                        response.injectTo(ctx);
                        resolve({ request, response });
                    }
                    catch(err) {
                        logger.error(err);
                        const failureBody = new FailureBody(err);
                        const response = new Response(failureBody);
                        response.injectTo(ctx);
                        resolve({ request, response });
                    }
                })
                .catch(err => {
                    try {
                        logger.error(err);
                        const failureBody = new FailureBody(err);
                        const response = new Response(failureBody);
                        response.injectTo(ctx);
                        resolve({ request, response });
                    }
                    catch(err) {
                        logger.error(err);
                        const failureBody = new FailureBody(err);
                        const response = new Response(failureBody);
                        response.injectTo(ctx);
                        resolve({ request, response });
                    }
                });
            }
            catch(err) {
                logger.error(err);
                const failureBody = new FailureBody(err);
                const response = new Response(failureBody);
                response.injectTo(ctx);
                resolve({ request, response });
            }
        });
    }

    /**
     * 监听端口
     */
    async listen() {
        const host = config.service.host;
        const port = config.service.port;
        await Promise.all([
            new Promise((resolve, reject) => {
                if(host === "0.0.0.0" || host === "localhost" || host === "127.0.0.1")
                    return resolve(null);
                this.app.listen(port, "localhost", err => {
                    if(err) return reject(err);
                    resolve(null);
                });
            }),
            new Promise((resolve, reject) => {
                this.app.listen(port, host, err => {
                    if(err) return reject(err);
                    resolve(null);
                });
            })
        ]);
        logger.success(`Server listening on port ${port} (${host})`);
    }

}

export default new Server();