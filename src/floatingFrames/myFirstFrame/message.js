const eventData = this.args.eventData;
const message = eventData.message || "Hello from My First Frame!";

this.communicate.runFrameScript("myFirstFrame", "myFirstFrameScript", {
  message: message,
});
