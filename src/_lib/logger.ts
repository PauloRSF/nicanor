import pino from "pino";

export const logger = pino({ level: "info" });

export type Logger = pino.Logger;
