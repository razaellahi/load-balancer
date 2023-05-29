const express = require('express')
const router = express.Router({})

router.get('/',async (_req,res,_next)=>{
    const healthcheck ={
        uptime : process.uptime(),
        responseTime : process.hrtime(),
        message : "OK",
        timestamp : Date.now()
    }
    try{
        res.send(healthcheck)
    }
    catch(err){
        healthcheck.message = err
        res.status(503).send()
    }
})
module.exports = router