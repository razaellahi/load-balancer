const {format,createLogger,transports} =require('winston')
const {timestamp,combine,printf,colorize,errors,json} = format
const logFormat = printf(({level,message,timestamp, stack})=>{
    return `${timestamp} | ${level} | ${stack || message}`;
});
const logger = createLogger({
    format:combine(
        colorize(),
        errors({stack:true}),
        timestamp({format:'YYYY-MM-DD HH:mm:ss'}),
        logFormat
        ),
    transports: [
        new transports.Console()
    ],
});

module.exports = logger;