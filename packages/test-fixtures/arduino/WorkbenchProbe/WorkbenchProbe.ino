// Synthetic dedicated-board fixture. No sensor, actuator or wiring verification.
void setup() {
  Serial.begin(9600);
  Serial.println("ROBOTICS_WORKBENCH_PROBE_V1");
}

void loop() {
  Serial.print("counter:");
  Serial.println(millis());
  delay(250);
}
