const ngrok = require("@ngrok/ngrok");

async function forwardToApp() {
	const forwarder = await ngrok.forward({
		addr: "localhost:8085",
		authtoken_from_env: true,
	});
	console.log(`Available at: ${forwarder.url()}`);
}

forwardToApp();