// The eye budget for the End portal, shared by the route line and the goal-spec advice.
// A portal takes 12 eyes less its filled frames. Finding the stronghold costs eyes on top: each throw breaks 1 in 5,
// and a drop can be lost. Gathering exactly 12 left 6 of 10 staged runs short at the frame (median 9 held), so the Nether
// gathers to a margin. Back in the Overworld only the frame minimum sends the body back for more.
export const FRAME_EYES = 12;
export const EYE_PLAN = 15;
// 2 blaze powder per rod: 8 rods make 16 powder, one spare over the 15 eyes.
export const ROD_PLAN = Math.ceil(EYE_PLAN / 2) + (EYE_PLAN % 2 === 0 ? 1 : 0);
export const PEARL_PLAN = EYE_PLAN;
