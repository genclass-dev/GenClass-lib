import pandas as pd
import numpy as np
from sklearn.linear_model import LogisticRegression

# Add data here
data = {
    "snowfall_cm": [18.4, 10, 19, 37, 18.8, 18.2, 7],
    "snow_day":    [1,   1,   1,   1,   1,   1,   0]
}


df = pd.DataFrame(data)


X = df[["snowfall_cm"]]
y = df["snow_day"]

model = LogisticRegression()
model.fit(X, y)

def predict_snow_day_probability(forecast_snowfall_cm):
    """
    Given a forecast snowfall (in centimeters), returns the probability of a snow day.
    """
    prob = model.predict_proba(np.array([[forecast_snowfall_cm]]))[0, 1]
    return prob


forecast = float(input("Enter forecasted snowfall (cm): "))
probability = predict_snow_day_probability(forecast)

print(f"\nForecasted snowfall: {forecast} cm")
print(f"Predicted probability of a snow day: {probability*100:.1f}%")

# A simple rule-based predictor for comparison:
def simple_snow_day_predictor(snowfall, threshold=15.0):
    """
    Returns True if the snowfall is at or above the threshold, else False.
    """
    return snowfall >= threshold

if simple_snow_day_predictor(forecast):
    print("Simple Rule Prediction: Likely a snow day!")
else:
    print("Simple Rule Prediction: Probably not a snow day.")
