import { Router } from "express";
import { userRouter } from "./user.js";
import { botRouter } from "./bot.js";

export const router = Router();

router.use("/user", userRouter);
router.use("/bot", botRouter);
