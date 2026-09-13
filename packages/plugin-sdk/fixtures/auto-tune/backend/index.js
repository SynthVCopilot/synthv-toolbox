export default {
  async invoke(method) {
    if (method === "action.run") return { accepted: true };
    throw new Error(`Unsupported plugin method: ${method}`);
  },
};
