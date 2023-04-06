const logger = require('./logger')
const client = require('prom-client')
const app = require('express')()


function startMetricServer(){
    const collectDefaultMetrics=client.collectDefaultMetrics
    collectDefaultMetrics()
    
    app.get('/metrics',async(req,res)=>{
        res.set("Content-Type",client.register.contentType)
        return res.send(await client.register.metrics())
    })
    app.listen(9100,()=>{
        logger.info("Metric server started at port 9100")
    })
}
module.exports = {startMetricServer}
