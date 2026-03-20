{
  "targets": [
    {
      "target_name": "piggy_input",
      "sources": ["piggy_input.c"],
      "conditions": [
        ["OS=='mac'", {
          "link_settings": {
            "libraries": [
              "-framework ApplicationServices",
              "-framework Carbon"
            ]
          }
        }]
      ]
    }
  ]
}
