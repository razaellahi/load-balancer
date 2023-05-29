require('dotenv').config();
var express = require('express')
var crypto = require('crypto')
var app = express();
const cors = require('cors')
const fs = require('fs')
var https = require('https')
var httpProxy = require('http-proxy');
const credentials = { key: fs.readFileSync("localhost.key"), cert: fs.readFileSync("localhost.cert") };
const metric = require('./utils/metrics')
const { Counter } = require('prom-client');
const logger = require('./utils/logger');
const ping = require('ping');


const successfulRequests = new Counter({
    name: 'successful_requests',
    help: 'Number of successful requests'
});

const totalRequests = new Counter({
    name: 'total_number_of_requests',
    help: 'Total number of requests'
});



class CH_LB {

    constructor(servers, replicas, algorithm) {
        this.loadFactor = 1.1
        this.replicas = replicas //number of replicas
        this.servers = [] //servers array
        this.keys = [] //resultant keys after being passed through hash function
        this.hashRing = {} //resultant hash value to server mapping (many:1)
        this.routeReq = {} //which client request mapped to which server
        this.headRing = []
        this.tailRing = []
        this.target = {} //address & port no
        this.algorithm = algorithm //md5 or any algorithm we would like
        this.load = {}
        this.totalLoad = 0
        this.detachedInstances = []
        for (let i = 0; i < servers.length; i++) {
            this.addServer(servers[i])
        }
    }
    addServer(serverName) {
        this.servers.push(serverName)

        for (let i = 0; i < this.replicas; i++) {
            const key = crypto.createHash(this.algorithm).update(serverName + ":" + i).digest('hex')
            this.keys.push(key);
            this.hashRing[key] = serverName;
        }
        this.keys.sort();
        this.load[serverName] = 0
    }

    routeRequest(request) {
        while (this.headRing.length) { this.headRing.pop(); }
        while (this.tailRing.length) { this.tailRing.pop(); }
        const hashkey = crypto.createHash(this.algorithm).update(request).digest('hex')
        for (let [key, value] of Object.entries(this.hashRing)) {
            if (key >= hashkey) {
                this.tailRing.push(key)
            }
            else {
                this.headRing.push(key)
            }
        }
        this.headRing.sort();
        this.tailRing.sort();

        let ip
        if (this.searchClient(request) == true) {
            ip = this.routeReq[request]
            let s = ip.split(":")
            this.target["host"] = s[0]
            this.target["port"] = s[1]
            logger.info("Mapping is already present")
            logger.info(this.target["host"] + ":" + this.target["port"])
            logger.info(request + " is mapped to " + this.target["host"] + ":" + this.target["port"])
            console.log(this.routeReq)
            return this.target;
        }
        else {
            if (this.tailRing.length != 0) {
                for (let i = 0; i < this.tailRing.length; i++) {
                    ip = this.hashRing[this.tailRing[i]]
                    let loadonServr = this.load[ip]

                    if (loadonServr + 1 <= this.calculateLoad()) {
                        this.routeReq[request] = ip
                        this.load[ip] = this.load[ip] + 1; this.totalLoad++
                        let s = ip.split(":")
                        this.target["host"] = s[0]
                        this.target["port"] = s[1]
                        logger.info(this.target["host"] + ":" + this.target["port"])
                        logger.info(request + " is mapped to " + this.target["host"] + ":" + this.target["port"])
                        return this.target;
                    }
                }
            }
            else {
                for (let i = 0; i < this.headRing.length; i++) {
                    ip = this.hashRing[this.headRing[i]]
                    let loadonServr = this.load[ip]
                    if (loadonServr + 1 <= this.calculateLoad()) {
                        this.routeReq[request] = ip
                        this.load[ip] = this.load[ip] + 1; this.totalLoad++
                        let s = ip.split(":")
                        this.target["host"] = s[0]
                        this.target["port"] = s[1]
                        logger.info(this.target["host"] + ":" + this.target["port"])
                        logger.info(request + " is mapped to " + this.target["host"] + ":" + this.target["port"])
                        return this.target;
                    }
                }
            }
        }
    }
    getReplicaNum(key, Serverip) {
        for (let i = 0; i < this.replicas; i++) {
            const hashkey = crypto.createHash(this.algorithm).update(Serverip + ":" + i).digest('hex')
            if (hashkey == key)
                return i;
        }
    }
    removeServer(serverName) {
        let reRouteReq = []
        for (let [key, value] of Object.entries(this.routeReq)) {
            if (value == serverName) {
                reRouteReq.push(key)
            }
        }
        for (let i = 0; i < this.servers.length; i++) {
            if (this.servers[i] == serverName) {
                this.servers.splice(i, 1)
            }
        }
        for (let i = 0; i < this.replicas; i++) {
            const key = crypto.createHash(this.algorithm).update(serverName + ":" + i).digest('hex')
            logger.info("Detaching " + this.hashRing[key])
            delete this.hashRing[key]
            for (let j = 0; j < this.keys.length; j++) {
                if (this.keys[j] == key) {
                    this.keys.splice(j, 1)
                }
            }
        }
        // for (let [key, value] of Object.entries(this.routeReq)) {
        //     if (value == serverName) {
        //         delete this.routeReq[key]
        //     }
        // }
        let loadR = this.load[serverName]
        this.totalLoad -= loadR
        for (let [key, value] of Object.entries(this.load)) {
            if (key == serverName) {
                delete this.load[key]
            }
        }
        for (let i = 0; i < reRouteReq.length; i++) {
            this.routeRequest(reRouteReq[i])
        }
    }
    calculateLoad() {
        let numOfServers = this.servers.length
        let avgload = this.loadFactor * (this.totalLoad / numOfServers)
        if (avgload == 0) {
            avgload = 1
        }
        logger.info("Average load on each server instance " + Math.ceil(avgload))
        return Math.ceil(avgload)
    }
    searchClient(request) {
        for (let [key, value] of Object.entries(this.routeReq)) {
            if (key == request) {
                return true;
            }
        }
        return false;
    }
}
const corsOpts = {
    origin: '*',

    methods: [
        'GET',
        'POST',
    ],
};

const counterMiddleware = (req, res, next) => {
    res.on('finish', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
            successfulRequests.inc();
        }
    });
    totalRequests.inc()
    next();
};

app.use(cors(corsOpts));
app.use(counterMiddleware)
const http = require('http');


let addresses = process.env.SERVERS.split(',');
let chlb = new CH_LB(addresses, 1, "md5")
setInterval(() => {
    if (chlb.detachedInstances.length != 0) {
        for (let i = 0; i < chlb.detachedInstances.length; i++) {
            let host = chlb.detachedInstances[i].split(":")
            var options = {
                hostname: host[0],
                port: host[1],
                path: '/agent/pull-mode-list',
                method: 'GET'
            };
            const req = http.request(options, (res) => {
                console.log('Agent manager instance is reachable');
                chlb.addServer(host[0] + ":" + host[1])
                let index = chlb.detachedInstances.indexOf(host[0] + ":" + host[1])
                if (index != -1) {
                    chlb.detachedInstances.splice(index, 1);
                }
            });

            req.on('error', (error) => {
                console.error(`Failed to reach agent manager instance: ${error.message}`);

            });

            req.end()
        }

    }
    // logger.info("Down servers at the moment : " + chlb.detachedInstances)
    // logger.info("Up servers at the moment " + chlb.servers)

}, 2000)


var proxy = httpProxy.createProxyServer({ ws: true });
var server = https.createServer(credentials, app).listen(8082, () => {
    logger.info("Load balancer is listening at port 8082...");
})
app.use(express.json())
app.use(express.urlencoded())
app.use(express.text())
var address
var userId

proxy.on('proxyReq', (proxyReq, req, res, options) => {

    if (!req.body || !Object.keys(req.body).length && req.method == "POST") {
        return;
    }
    let contentType = proxyReq.getHeader('Content-Type');
    let bodyData;
    if (contentType != undefined) {
        if (contentType.includes('application/json')) {
            bodyData = JSON.stringify(req.body);
        }
        if (contentType.includes('text/plain')) {
            bodyData = req.body
        }
        if (bodyData) {
            proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
            proxyReq.write(bodyData);
        }
    }
});
proxy.on('proxyReqWs', (proxyReq, req, socket, options, head) => {
    //before proxying websocket data
});

app.use('/agent-lb', function (req, res) {
    logger.info("Request Url: " + req.url + " hostname: " + req.hostname)
    logger.info("Request coming from " + req.connection.remoteAddress)
    username = req.body.username
    try {
        if (req.body.username != undefined) {
            logger.info("Username " + req.body.username)
            address = chlb.routeRequest(req.body.username)
            proxy.web(req, res, { target: { protocol: 'https', host: address.host, port: address.port } })
        }
    }
    catch (error) {
        logger.error(error)
    }


})

app.use('/re', function (req, res) {
    logger.info("Request Url: " + req.url + " hostname: " + req.hostname)
    logger.info("Request coming from " + req.connection.remoteAddress)
    if (req.url == "/agent/assign-task") {
        userId = req.body.ccUser.keycloakUser.id
        // console.log(req.body.ccUser)
    }
    else if (req.url == "/agent/revoke-task") {
        userId = req.body.agentId
        // console.log(req.body)
    }
    address = chlb.routeRequest(userId)
    proxy.web(req, res, { target: { host: address.host, port: address.port } })

})

proxy.on('proxyRes', function (proxyRes, req, res) {
    logger.info("Status code for URL " + req.url + " " + proxyRes.statusCode + " " + proxyRes.statusMessage);
})
app.use('/socket.io', function (req, res) {
    logger.info("Request Url " + req.url + " hostname: " + req.hostname)
    logger.info("Request coming from " + req.connection.remoteAddress)
    logger.info("requestedId ===========> ", req.query.agentId);
    userId = req.query.agentId
    // if (req.body != null) {

    //     var str = req.body
    //     var str2 = str.toString()
    //     if (str2.includes("agent")) {
    //         var substr = str2.substring(2).replace(/[\\]/g, "").replace("\"{", "{").replace("}\"", "}")
    //         if (substr != null) {
    //             logger.info(JSON.parse(substr))
    //             username = JSON.parse(substr).agent.username
    //         }
    //     }
    // }

    if (userId != undefined) {
        address = chlb.routeRequest(userId)
        proxy.web(req, res, { target: { host: address.host, port: address.port, path: '/socket.io' } })
        logger.info(userId + " is mapped to " + address.host + ":" + address.port)
    }

})

server.on('upgrade', function (req, socket, head) {
    logger.info("Upgraded to websockets")
    proxy.ws(req, socket, head, { target: { host: address.host, port: address.port, path: '/socket.io' } });
});
proxy.on('error', function (err, req, res) {
    logger.info("Error on " + req.url + " " + err)
    chlb.detachedInstances.push(address.host + ":" + address.port)
    chlb.removeServer(address.host + ":" + address.port)
    logger.info("Available servers at the moment :" + chlb.servers)
    logger.info("Unvailable servers at the moment :" + chlb.detachedInstances)
    console.log(addresses)
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('Service Unavailable');
})

app.use('/healthcheck', require('./route/healthcheck'));


process.on('SIGTERM', () => {
    logger.info('SIGTERM signal received.');
    server.close();
    proxy.close();
    process.exit(0)
});
metric.startMetricServer()
