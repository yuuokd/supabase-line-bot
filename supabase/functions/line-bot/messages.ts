
export const confirmMessage = () => {
  return {
    "type": "template",
    "altText": "this is a confirm template",
    "template": {
      "type": "confirm",
      "text": "Are you sure?",
      "actions": [
        {
          "type": "postback",
          "label": "Yes",
          "inputOption": "openRichMenu",
          "data": "action=buy&itemid=111",
        },
        {
          "type": "postback",
          "label": "No",
          "data": "action=buy&itemid=111",
          "inputOption": "openKeyboard",
          "fillInText": 'inputed value'
        }
      ]
    }
  }
}
