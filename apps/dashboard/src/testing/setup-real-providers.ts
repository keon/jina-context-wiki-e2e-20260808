import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The provider integration suite needs a browser-shaped host but deliberately
// does not register the component suite's DashboardProvider module double.
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
