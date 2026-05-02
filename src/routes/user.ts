import { Router, Request, Response } from "express";

export const userRouter = Router();

// GET /api/user/:id
userRouter.get("/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  // TODO: fetch user from database
  res.json({ id, message: "User endpoint — connect your DB here" });
});
