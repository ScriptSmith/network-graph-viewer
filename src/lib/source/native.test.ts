import { FIXTURE_DATASET, runContract } from "./contract";
import { nativeSource } from "./native";

runContract("native", async () => nativeSource(FIXTURE_DATASET));
